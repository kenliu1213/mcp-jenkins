import { JenkinsClient } from "../lib/jenkins-client.js"

export interface GetViewInput {
  viewName: string
}

export const getView = async (client: JenkinsClient, input: GetViewInput) =>
  client.getView(input.viewName)
