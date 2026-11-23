import { app } from './app';
import { env } from './config/env';
import { startRoomCleanup } from './services/roomCleanup';
import { startRoomLevels } from './services/roomLevels';
import { startSalaryJob } from './services/salaryService';
import { startVipExpiry } from './services/vipExpiry';

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`Hyper Live backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  startRoomCleanup();
  startRoomLevels();
  startSalaryJob();
  startVipExpiry();
});

const stop = () => {
  console.log('Stopping...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
