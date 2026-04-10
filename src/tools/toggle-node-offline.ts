import { JenkinsClient } from "../lib/jenkins-client.js"

export interface ToggleNodeOfflineInput {
  nodeName: string
  offlineMessage?: string
}

export const toggleNodeOffline = async (
  client: JenkinsClient,
  input: ToggleNodeOfflineInput,
) => client.toggleNodeOffline(input.nodeName, input.offlineMessage)
