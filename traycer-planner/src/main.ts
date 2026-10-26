#!/usr/bin/env node
// src/main.ts — process entry point. All logic lives in cli.ts so it can be tested.
import dotenv from 'dotenv';
import { defaultIO, runCli } from './cli.js';

dotenv.config({ quiet: true });

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

runCli(process.argv.slice(2), defaultIO(controller.signal)).then(code => {
    process.exitCode = code;
});
