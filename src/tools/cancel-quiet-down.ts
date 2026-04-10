import { JenkinsClient } from "../lib/jenkins-client.js"

export interface CancelQuietDownInput {}

export const cancelQuietDown = async (
  client: JenkinsClient,
  _input: CancelQuietDownInput,
) => client.cancelQuietDown()
