import { JenkinsClient } from "../lib/jenkins-client.js"

export interface CopyJobInput {
  fromName: string
  newName: string
}

export const copyJob = async (client: JenkinsClient, input: CopyJobInput) =>
  client.copyJob(input.fromName, input.newName)
