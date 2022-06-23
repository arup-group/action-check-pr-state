import {ActionContext} from './action-context'
import {getInput} from '@actions/core'
import fetch from 'node-fetch'
import {
  ChecksGetResponseData,
  PullsListReviewsResponseData,
  ChecksListForRefResponseData,
  PullsGetResponseData
} from '@octokit/types/dist-types/generated/Endpoints'

const base64token = Buffer.from(`PAT:${process.env.DEVOPS_TOKEN}`).toString('base64')
/*
 * Main logic
 */
export async function prCheck(actionContext: ActionContext): Promise<void> {
  try {
    const approvalsRequiredString = getInput('approvalsRequired')
    const pr = getInput('pr')

    const approvalsRequired = approvalsRequiredString ? Number(approvalsRequiredString) : 0

    let pullRequests = await actionContext.octokit.paginate(actionContext.octokit.pulls.list, {
      ...actionContext.context.repo,
      state: 'open',
      sort: 'updated',
      direction: 'asc'
    })

    if (pr) {
      // filter by pr number if supplied
      pullRequests = pullRequests.filter(pullRequest => pullRequest.number === +pr)
    }

    const fullInfoPromise = pullRequests.map(async pull => ({
      reviews: await actionContext.octokit.pulls.listReviews({
        ...actionContext.context.repo,
        pull_number: pull.number
      }),
      pr: await actionContext.octokit.pulls.get({
        ...actionContext.context.repo,
        pull_number: pull.number
      }),
      checks: await actionContext.octokit.checks.listForRef({
        ...actionContext.context.repo,
        ref: pull.head.sha
      })
    }))

    const fullInfo = await Promise.all(fullInfoPromise)

    const checkInProgress = process.env.DEVOPS_TOKEN ? await checkInDevops(actionContext) : checkInPrs(fullInfo)

    if (checkInProgress) {
      actionContext.debug('check in progress')
    } else {
      actionContext.debug('No Check in progress')
      const rerunCandidates = fullInfo.filter(pull => {
        actionContext.debug(`pull number: ${pull.pr.data.number}`)

        const approved = isApproved(pull.reviews.data, approvalsRequired)
        actionContext.debug(`Has two approvals: ${approved}`)

        const mergeable_state = pull.pr.data.mergeable_state
        actionContext.debug(`mergeable state: ${mergeable_state}`)

        const prConflicted = conflicted(pull.pr.data)
        actionContext.debug(`Conflicted PR: ${prConflicted}`)

        const failed = allProjectsFailed(pull.checks.data)
        actionContext.debug(`PR failed: ${failed}`)

        const prUnknownMergeState = unknown(pull.pr.data)
        actionContext.debug(`PR unknown merge state: ${prUnknownMergeState}`)

        const behind = branchBehindDevelop(pull.pr.data)
        actionContext.debug(`behind: ${behind}`)

        const prDraft = draft(pull.pr.data)
        actionContext.debug(`draft: ${prDraft}`)

        const success = allProjectsSuccess(pull.checks.data)
        actionContext.debug(`Check success: ${success}`)

        const notRan = allProjectsNotRan(pull.checks.data)
        actionContext.debug(`Check not ran: ${notRan}`)

        const disableAutoCiLabel = disableLabel(pull.pr.data)
        actionContext.debug(`disable CI checks label set: ${disableAutoCiLabel}`)

        return (
          !prDraft &&
          approved &&
          !prConflicted &&
          !failed &&
          !prUnknownMergeState &&
          !disableAutoCiLabel &&
          (behind || notRan)
        )
      })

      if (rerunCandidates.length > 0) {
        const rerun = rerunCandidates[0]
        actionContext.setOutput('pullRequestToRerun', rerun.pr.data.number.toString())
        actionContext.setOutput('headRef', rerun.pr.data.head.ref)
        actionContext.setOutput('baseRef', rerun.pr.data.base.ref)
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    actionContext.setFailed(error.message)
  }
}

/**
 * Helper functions
 */
function allProjectsCheckHasInProgressStatus(checkRunsData: ChecksListForRefResponseData): boolean {
  return (
    checkRunsData.check_runs.filter(check => allProjectsCheckRun(check) && check.status.toLowerCase() === 'in_progress')
      .length > 0
  )
}

function isApproved(reviews: PullsListReviewsResponseData, approvalsRequired: number): boolean {
  return reviews.filter(review => review.state === 'APPROVED').length >= approvalsRequired
}

function allProjectsFailed(checkRunsData: ChecksListForRefResponseData): boolean {
  return checkRunsData.check_runs.filter(check => allProjectsCheckRun(check) && checkRunFailed(check)).length > 0
}

function allProjectsSuccess(checkRunsData: ChecksListForRefResponseData): boolean {
  return checkRunsData.check_runs.filter(check => allProjectsCheckRun(check) && checkRunSuccess(check)).length > 0
}

function allProjectsNotRan(checkRunsData: ChecksListForRefResponseData): boolean {
  return checkRunsData.check_runs.filter(check => allProjectsCheckRun(check)).length === 0
}

function checkRunFailed(run: ChecksGetResponseData): boolean {
  return run.conclusion?.toLowerCase() === 'failure'
}

function checkRunSuccess(run: ChecksGetResponseData): boolean {
  return run.conclusion?.toLowerCase() === 'success'
}

function allProjectsCheckRun(run: ChecksGetResponseData): boolean {
  return run.name === 'All Projects'
}

function branchBehindDevelop(pr: PullsGetResponseData): boolean {
  return pr.mergeable_state?.toLowerCase() === 'behind'
}

function unknown(pr: PullsGetResponseData): boolean {
  return pr.mergeable_state?.toLowerCase() === 'unknown'
}

function conflicted(pr: PullsGetResponseData): boolean {
  return pr.mergeable_state?.toLowerCase() === 'dirty'
}

function draft(pr: PullsGetResponseData): boolean {
  return pr.draft
}

function disableLabel(pr: PullsGetResponseData): boolean {
  return pr.labels?.filter(label => label.name === 'disable-auto-ci-trigger').length !== 0
}

async function checkInDevops(actionContext: ActionContext): Promise<boolean> {
  const poolIds = ['12', '22', '24', '25', '27', '28', '29', '31', '33', '34', '35']

  const jobs = poolIds.map(async poolId => {
    const response = await fetch(
      `https://dev.azure.com/oasys-software/_apis/distributedtask/pools/${poolId}/jobrequests?api-version=5.1`,
      {
        headers: {
          Authorization: `Basic ${base64token}`
        }
      }
    )

    return await response.json()
  })

  const resolvedJobs = await Promise.all(jobs)
  const allPools = resolvedJobs.reduce((acc, curr) => acc.concat(curr.value), [])

  let needToWait = false

  for (const job of allPools) {
    if (!job.result && job.definition?.name === 'All Projects') {
      const buildLink = await fetch(job.owner._links.self.href, {
        headers: {
          Authorization: `Basic ${base64token}`
        }
      })
      const build = await buildLink.json()

      if (build.reason === 'pullRequest') {
        const pr = build.triggerInfo['pr.number'];
        if(!pr) break;
        actionContext.debug(`Checking ${pr} to see if it's been approved`)
        const reviews = await actionContext.octokit.pulls.listReviews({
          ...actionContext.context.repo,
          pull_number: +pr
        })
        // Only wait for PRs that have been approved
        if (isApproved(reviews.data, 2)) {
          actionContext.debug(`All Projects build triggered by: ${build.sourceBranch}`)
          needToWait = true
          break
        }
      }
    }
  }

  return needToWait
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkInPrs(fullInfo: any): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fullInfo.filter((pull: any) => allProjectsCheckHasInProgressStatus(pull.checks.data)).length > 0
}
