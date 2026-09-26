import { createApp } from "./app.js";
import { createStore } from "./store-factory.js";

const port = Number(process.env.PORT || 3001);
const app = createApp(createStore());

app.listen(port, () => {
  console.log(`R&R Case Core API listening on http://localhost:${port}`);
});
