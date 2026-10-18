import { runPipeline } from './run.mjs';

const options = {
  publish: true,
  start: process.env.REQUEST_START || undefined,
  end: process.env.REQUEST_END || undefined,
  refresh: process.env.REQUEST_REFRESH === 'true',
};
if (options.refresh && (!options.start || !options.end)) throw new Error('Refresh requires an explicit date range');
runPipeline({ options }).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
