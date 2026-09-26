import { createApp } from "./src/app.js";
import { createStore } from "./src/store-factory.js";

const app = createApp(createStore());

export default app;
