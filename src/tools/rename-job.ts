import { JenkinsClient } from "../lib/jenkins-client.js"

export interface RenameJobInput {
  jobName: string
  newName: string
}

export const renameJob = async (client: JenkinsClient, input: RenameJobInput) =>
  client.renameJob(input.jobName, input.newName)
