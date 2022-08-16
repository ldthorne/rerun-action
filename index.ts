import {config} from 'dotenv';
import readline from 'readline'
import { Octokit } from "octokit";

config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const authToken = process.env.GITHUB_TOKEN;
if (!authToken) {
  throw new Error('GITHUB_TOKEN environment variable is not set');
}

const octokit = new Octokit({ auth: authToken });

const readLineAsync = (message: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    rl.question(message, (answer: string) => {
      resolve(answer);
    });
  });
}

const sleep = (ms: number) => {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const getAttempt = async (runId: number, attemptNumber: number) => {
  const currentAttemptRes = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}', {
    owner: 'headway',
    repo: 'headway',
    run_id: runId,
    attempt_number: attemptNumber,
  });

  return currentAttemptRes.data;
}


const getRun = async (runId: number) => {
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
      owner: 'headway',
      repo: 'headway',
      run_id: runId,
    });
    return res.data;
  } catch(error) {
    console.error(`Error getting run ${runId}`, error);
  }
}


const getRunIdFromUser = async (): Promise<number> => {
  if (process.env.GITHUB_ACTION_RUN_ID) {
    return parseInt(process.env.GITHUB_ACTION_RUN_ID);
  }

  const runId = await readLineAsync('Enter run id: ');
  if (!runId) {
    return await getRunIdFromUser();
  }
  return parseInt(runId);
}

const getPollFrequencyFromUser = async (): Promise<number> => {
  if (process.env.POLL_FREQUENCY_MS) {
    return parseInt(process.env.POLL_FREQUENCY_MS);
  }

  const pollFrequencySeconds = await readLineAsync('Consider how long the workflow typically takes to run. How often should we poll to check if it\'s done? Enter time in seconds (default is 10): ');
  if (!pollFrequencySeconds) {
    return 10_000;
  }
  return parseInt(pollFrequencySeconds) * 1000;
}

const getNumberOfAttemptsFromUser = async (): Promise<number> => {
  if (process.env.NUMBER_OF_ATTEMPTS) {
    return parseInt(process.env.NUMBER_OF_ATTEMPTS);
  }

  const numAttempts = await readLineAsync('Enter the number of times you would like the action attempted (default is 1000): ');
  if (!numAttempts) {
    return 100;
  }
  return parseInt(numAttempts);
}


const sleepUntilAttemptCompleted = async ({runId, attemptNumber, pollFrequencyMs }: {runId: number, attemptNumber: number, pollFrequencyMs: number}) => {
  const attempt = await getAttempt(runId, attemptNumber);
  if (attempt.status === 'completed') {
    return;
  }
  await sleep(pollFrequencyMs);
  await sleepUntilAttemptCompleted({runId, attemptNumber, pollFrequencyMs});
}

const main = async () => {
  let successes = 0;
  let failures = 0;

  const RUN_ID = await getRunIdFromUser();
  const POLL_FREQUENCY_MS = await getPollFrequencyFromUser();
  const NUMBER_OF_ATTEMPTS = await getNumberOfAttemptsFromUser();

  const initialRun = await getRun(RUN_ID);

  if (!initialRun) {
    throw new Error('Could not find run');
  }

  const initialAttemptCount = initialRun.run_attempt || 1;
  console.log(`Initial attempt count: ${initialAttemptCount}`);
  let iteration = 1;

  while (iteration <= NUMBER_OF_ATTEMPTS) {
    console.log(`Run #${iteration}`)

    await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
      owner: 'headway',
      repo: 'headway',
      run_id: RUN_ID,
    });

    await sleep(10000)

    const expectedAttemptCount = initialAttemptCount + iteration

    const currentAttempt = await getAttempt(RUN_ID, expectedAttemptCount);

    if (!currentAttempt) {
      throw new Error(`Attempt ${expectedAttemptCount} was not created in time`);
    }

    console.log(`Successfully created attempt ${expectedAttemptCount}: ${currentAttempt.id}`);

    await sleepUntilAttemptCompleted({ runId: RUN_ID, attemptNumber: expectedAttemptCount, pollFrequencyMs: POLL_FREQUENCY_MS });

    const finishedAttempt = await getAttempt(RUN_ID, expectedAttemptCount);

    if (finishedAttempt.conclusion === 'success') {
      successes++;
    } else if(finishedAttempt.conclusion === 'failure') {
      failures++;
    } else {
      console.log('Unknown conclusion', finishedAttempt.conclusion);
    }

    console.log(`Results as of iteration #${iteration}: ${successes} successes, ${failures} failures`);

    iteration++;
  }

  console.log(`Successes: ${successes}, Failures: ${failures}`);
}


main().catch(e => {
  console.error(e);
  process.exit(1);
});
