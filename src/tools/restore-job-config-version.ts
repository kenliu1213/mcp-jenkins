import { JenkinsClient } from '../lib/jenkins-client.js';

export interface RestoreJobConfigVersionInput {
  jobName: string;
  timestamp: string;
}

export const restoreJobConfigVersion = async (
  client: JenkinsClient,
  input: RestoreJobConfigVersionInput,
) => client.restoreJobConfigVersion(input.jobName, input.timestamp);
