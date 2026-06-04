import { JenkinsClient } from '../lib/jenkins-client.js';

export interface DiffJobConfigVersionsInput {
  jobName: string;
  fromTimestamp: string;
  toTimestamp: string;
}

export const diffJobConfigVersions = async (
  client: JenkinsClient,
  input: DiffJobConfigVersionsInput,
) =>
  client.diffJobConfigVersions(
    input.jobName,
    input.fromTimestamp,
    input.toTimestamp,
  );
