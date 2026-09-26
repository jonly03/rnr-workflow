import express from "express";
import { createApp } from "./src/app.js";
import { createStore } from "./src/store-factory.js";

// Keep the framework import in the Vercel entrypoint so Express is detected
// as the app runtime. The app factory owns middleware and routes.
void express;

const app = createApp(createStore());

export default app;
