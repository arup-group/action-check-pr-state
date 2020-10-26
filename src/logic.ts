import {ActionContext} from './action-context'
import {getInput} from '@actions/core'
import {
  ChecksGetResponseData,
  PullsListReviewsResponseData,
  ChecksListForRefResponseData,
  PullsGetResponseData
} from '@octokit/types/dist-types/generated/Endpoints'

/*
 * Main logic
 */
export async function prCheck(actionContext: ActionContext): Promise<void> {
  try {
    const approvalsRequiredString = getInput('approvalsRequired')

    const approvalsRequired = approvalsRequiredString ? Number(approvalsRequiredString) : 0

    const pullRequests = await actionContext.octokit.paginate(actionContext.octokit.pulls.list, {
      ...actionContext.context.repo,
      state: 'open',
      sort: 'updated',
      direction: 'asc'
    })

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

    const checkInProgress = fullInfo.filter(pull => allProjectsCheckHasInProgressStatus(pull.checks.data)).length > 0

    if (checkInProgress) {
      actionContext.debug('check in progress')
    } else {
      actionContext.debug('No Check in progress')
      const rerunCandidates = fullInfo.filter(pull => {
        actionContext.debug(`pull number: ${pull.pr.data.number}`)

        const approved = isApproved(pull.reviews.data, approvalsRequired)
        actionContext.debug(`Has two approvals: ${approved}`)

        const prConflicted = conflicted(pull.pr.data)
        actionContext.debug(`Conflicted PR: ${prConflicted}`)

        const completed = allProjectsAlreadyCompleted(pull.checks.data)
        actionContext.debug(`Already in completed state: ${completed}`)

        const behind = branchBehindDevelop(pull.pr.data)
        actionContext.debug(`behind: ${behind}`)

        const prDraft = draft(pull.pr.data)
        actionContext.debug(`draft: ${prDraft}`)

        return !prDraft && approved && !prConflicted && (!completed || behind)
      })

      if (rerunCandidates.length > 0) {
        const rerun = rerunCandidates[0]
        actionContext.setOutput('pullRequestToRerun', rerun.pr.data.number.toString())
        actionContext.setOutput('headRef', rerun.pr.data.head.ref)
        actionContext.setOutput('baseRef', rerun.pr.data.base.ref)
      }
    }
  } catch (error) {
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

function allProjectsAlreadyCompleted(checkRunsData: ChecksListForRefResponseData): boolean {
  return checkRunsData.check_runs.filter(check => allProjectsCheckRun(check) && checkRunCompleted(check)).length > 0
}

function checkRunCompleted(run: ChecksGetResponseData): boolean {
  return run.conclusion.toLowerCase() === 'success' || run.conclusion.toLowerCase() === 'failure'
}

function allProjectsCheckRun(run: ChecksGetResponseData): boolean {
  return run.name === 'All Projects'
}

function branchBehindDevelop(pr: PullsGetResponseData): boolean {
  return pr.mergeable_state.toLowerCase() === 'behind'
}

function conflicted(pr: PullsGetResponseData): boolean {
  return pr.mergeable_state.toLowerCase() === 'dirty'
}

function draft(pr: PullsGetResponseData): boolean {
  return pr.draft
}
