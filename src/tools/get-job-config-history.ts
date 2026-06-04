import { JenkinsClient } from '../lib/jenkins-client.js';

export interface GetJobConfigHistoryInput {
  jobName: string;
}

export const getJobConfigHistory = async (
  client: JenkinsClient,
  input: GetJobConfigHistoryInput,
) => client.getJobConfigHistory(input.jobName);
