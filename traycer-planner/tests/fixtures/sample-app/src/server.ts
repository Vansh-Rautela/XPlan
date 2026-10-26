import express from 'express';
import { loadConfig } from './config.js';
import { requestLogger } from './middleware/requestLogger.js';
import { healthRouter } from './routes/health.js';
import { usersRouter } from './routes/users.js';

export function createApp() {
    const app = express();
    app.use(express.json());
    app.use(requestLogger);
    app.use('/health', healthRouter);
    app.use('/users', usersRouter);
    return app;
}

const config = loadConfig();
createApp().listen(config.port, () => {
    console.log(`listening on ${config.port}`);
});
