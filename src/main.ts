import {debug, setFailed, getInput, setOutput} from '@actions/core'
import * as GitHub from '@actions/github'
import {context} from '@actions/github'
import {prCheck} from './logic'

async function run(): Promise<void> {
  try {
    debug('start action')
    const token = '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'
    // if (!token) throw ReferenceError('No Token found')
    debug('attempt to run action')
    await prCheck({
      debug,
      setFailed,
      getInput,
      setOutput,
      octokit: GitHub.getOctokit(token),
      context
    })
  } catch (error) {
    setFailed(error.message)
  }
}

run()
