import { JenkinsClient } from "../lib/jenkins-client.js"

export interface MoveJobInput {
  jobName: string
  destination: string
  overwrite?: boolean
}

export const moveJob = async (
  client: JenkinsClient,
  input: MoveJobInput,
) => client.moveJob(input.jobName, input.destination, input.overwrite ?? false)
