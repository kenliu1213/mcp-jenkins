import { JenkinsClient } from "../lib/jenkins-client.js"

export interface GetNodeInput {
  nodeName: string
}

export const getNode = async (client: JenkinsClient, input: GetNodeInput) =>
  client.getNode(input.nodeName)
