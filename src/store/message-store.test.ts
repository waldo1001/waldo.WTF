import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { runMessageStoreContract } from "./message-store-contract.js";

runMessageStoreContract(
  "InMemoryMessageStore",
  () => new InMemoryMessageStore(),
);
