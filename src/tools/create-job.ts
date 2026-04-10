import { JenkinsClient } from "../lib/jenkins-client.js"

export interface CreateJobInput {
  jobName: string
  configXml: string
}

export const createJob = async (client: JenkinsClient, input: CreateJobInput) =>
  client.createJob(input.jobName, input.configXml)
