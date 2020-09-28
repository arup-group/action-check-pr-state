import {Context} from '@actions/github/lib/context'
import {Octokit} from '@octokit/core/dist-types'
import {RestEndpointMethods} from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/method-types'

export interface ActionContext {
  debug: (message: string) => void
  setFailed: (message: string) => void
  getInput: (parameter: string) => string
  setOutput: (name: string, value: string) => void
  octokit: Octokit & RestEndpointMethods
  context: Context
}
