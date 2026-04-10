import { JenkinsClient } from "../lib/jenkins-client.js"

export interface UpdateJobConfigInput {
  jobName: string
  configXml: string
}

export const updateJobConfig = async (
  client: JenkinsClient,
  input: UpdateJobConfigInput,
) => client.updateJobConfig(input.jobName, input.configXml)
