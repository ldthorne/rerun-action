import { config } from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import readline from "readline";
import { Octokit } from "octokit";
import { promisify } from "util";
import { pipeline } from "stream";

config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const authToken = process.env.GITHUB_TOKEN;
if (!authToken) {
  throw new Error("GITHUB_TOKEN environment variable is not set");
}

const octokit = new Octokit({ auth: authToken });

const readLineAsync = (message: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    rl.question(message, (answer: string) => {
      resolve(answer);
    });
  });
};

const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const getAttempt = async ({
  runId,
  attemptNumber,
  repoName,
  repoOwner,
}: {
  runId: number;
  attemptNumber: number;
  repoName: string;
  repoOwner: string;
}) => {
  const currentAttemptRes = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}",
    {
      owner: repoOwner,
      repo: repoName,
      run_id: runId,
      attempt_number: attemptNumber,
    }
  );

  return currentAttemptRes.data;
};

const getRun = async ({
  runId,
  repoName,
  repoOwner,
}: {
  runId: number;
  repoName: string;
  repoOwner: string;
}) => {
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      {
        owner: repoOwner,
        repo: repoName,
        run_id: runId,
      }
    );
    return res.data;
  } catch (error) {
    console.error(`Error getting run ${runId}`, error);
  }
};

const getRunIdFromUser = async (): Promise<number> => {
  if (process.env.GITHUB_ACTION_RUN_ID) {
    return parseInt(process.env.GITHUB_ACTION_RUN_ID);
  }

  const runId = await readLineAsync("Enter run id: ");
  if (!runId) {
    return await getRunIdFromUser();
  }
  return parseInt(runId);
};

const getPollFrequencyFromUser = async (): Promise<number> => {
  if (process.env.POLL_FREQUENCY_MS) {
    return parseInt(process.env.POLL_FREQUENCY_MS);
  }

  const pollFrequencySeconds = await readLineAsync(
    "Consider how long the workflow typically takes to run. How often should we poll to check if it's done? Enter time in seconds (default is 10): "
  );
  if (!pollFrequencySeconds) {
    return 10_000;
  }
  return parseInt(pollFrequencySeconds) * 1000;
};

const getNumberOfAttemptsFromUser = async (): Promise<number> => {
  if (process.env.NUMBER_OF_ATTEMPTS) {
    return parseInt(process.env.NUMBER_OF_ATTEMPTS);
  }

  const numAttempts = await readLineAsync(
    "Enter the number of times you would like the action attempted (default is 1000): "
  );
  if (!numAttempts) {
    return 100;
  }
  return parseInt(numAttempts);
};

const getRepoFromUser = async (): Promise<string> => {
  if (process.env.GITHUB_REPOSITORY_NAME) {
    return process.env.GITHUB_REPOSITORY_NAME;
  }

  const repo = await readLineAsync("Enter repository name: ");
  if (!repo) {
    return await getRepoFromUser();
  }
  return repo;
};

const getRepoOwnerFromUser = async (): Promise<string> => {
  if (process.env.GITHUB_REPOSITORY_OWNER) {
    return process.env.GITHUB_REPOSITORY_OWNER;
  }
  const repoOwner = await readLineAsync("Enter repository's owner: ");
  if (!repoOwner) {
    return await getRepoOwnerFromUser();
  }
  return repoOwner;
};

const downloadFile = async ({
  url,
  saveToPath,
}: {
  url: string;
  saveToPath: string;
}) => {
  const streamPipeline = promisify(pipeline);

  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(
      `Unexpected response while downloading file ${response.statusText}`
    );
  }

  await streamPipeline(response.body, fs.createWriteStream(saveToPath));
};

const downloadArtifactsForFailedAttempt = async ({
  runId,
  attemptNumber,
  repoName,
  repoOwner,
}: {
  runId: number;
  attemptNumber: number;
  repoName: string;
  repoOwner: string;
}) => {
  console.log(`Downloading artifacts for failed attempt #${attemptNumber}`);
  const attempt = await getAttempt({
    runId,
    attemptNumber,
    repoName,
    repoOwner,
  });

  const artifactsRes = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
    {
      owner: repoOwner,
      repo: repoName,
      run_id: attempt.id,
    }
  );

  if (artifactsRes.data.artifacts.length === 0) {
    return;
  }

  for (const artifact of artifactsRes.data.artifacts) {
    const artifactRes = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
      {
        owner: repoOwner,
        repo: repoName,
        artifact_id: artifact.id,
        archive_format: "zip",
      }
    );

    if (!artifactRes.url) {
      throw new Error("No download url returned");
    }

    const fileName = `${artifact.name}.zip`;
    const artifactFilePath = `./artifacts/runs/${runId}/attempts/${attemptNumber}/`;

    await fs.promises.mkdir(artifactFilePath, { recursive: true });

    await downloadFile({
      url: artifactRes.url,
      saveToPath: `${artifactFilePath}${fileName}`,
    });
  }
};

const sleepUntilAttemptCompleted = async ({
  runId,
  attemptNumber,
  pollFrequencyMs,
  repoName,
  repoOwner,
}: {
  runId: number;
  attemptNumber: number;
  pollFrequencyMs: number;
  repoName: string;
  repoOwner: string;
}) => {
  const attempt = await getAttempt({
    runId,
    attemptNumber,
    repoName,
    repoOwner,
  });
  if (attempt.status === "completed") {
    return;
  }
  await sleep(pollFrequencyMs);
  await sleepUntilAttemptCompleted({
    runId,
    attemptNumber,
    pollFrequencyMs,
    repoName,
    repoOwner,
  });
};

const main = async () => {
  let successes = 0;
  let failures = 0;

  const RUN_ID = await getRunIdFromUser();
  const POLL_FREQUENCY_MS = await getPollFrequencyFromUser();
  const NUMBER_OF_ATTEMPTS = await getNumberOfAttemptsFromUser();
  const REPO_NAME = await getRepoFromUser();
  const REPO_OWNER = await getRepoOwnerFromUser();

  const initialRun = await getRun({
    runId: RUN_ID,
    repoName: REPO_NAME,
    repoOwner: REPO_OWNER,
  });

  if (!initialRun) {
    throw new Error("Could not find run");
  }

  const initialAttemptCount = initialRun.run_attempt || 1;
  console.log(`Initial attempt count: ${initialAttemptCount}`);
  let iteration = 1;

  while (iteration <= NUMBER_OF_ATTEMPTS) {
    console.log(`Run #${iteration}`);

    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
      {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        run_id: RUN_ID,
      }
    );

    await sleep(10000);

    const expectedAttemptCount = initialAttemptCount + iteration;

    const currentAttempt = await getAttempt({
      runId: RUN_ID,
      attemptNumber: expectedAttemptCount,
      repoName: REPO_NAME,
      repoOwner: REPO_OWNER,
    });

    if (!currentAttempt) {
      throw new Error(
        `Attempt ${expectedAttemptCount} was not created in time`
      );
    }

    console.log(
      `Successfully created attempt ${expectedAttemptCount}: ${currentAttempt.id}`
    );

    await sleepUntilAttemptCompleted({
      runId: RUN_ID,
      attemptNumber: expectedAttemptCount,
      pollFrequencyMs: POLL_FREQUENCY_MS,
      repoName: REPO_NAME,
      repoOwner: REPO_OWNER,
    });

    const finishedAttempt = await getAttempt({
      runId: RUN_ID,
      attemptNumber: expectedAttemptCount,
      repoName: REPO_NAME,
      repoOwner: REPO_OWNER,
    });

    console.log(
      `Attempt ${expectedAttemptCount} finished with conclusion ${finishedAttempt.conclusion}`
    );

    if (finishedAttempt.conclusion === "success") {
      successes++;
    } else if (finishedAttempt.conclusion === "failure") {
      await downloadArtifactsForFailedAttempt({
        runId: RUN_ID,
        attemptNumber: expectedAttemptCount,
        repoName: REPO_NAME,
        repoOwner: REPO_OWNER,
      });
      failures++;
    } else {
      console.error("Unknown conclusion", finishedAttempt.conclusion);
    }

    console.log(
      `Results as of iteration #${iteration}: ${successes} successes, ${failures} failures`
    );

    iteration++;
  }

  console.log(`Successes: ${successes}, Failures: ${failures}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
