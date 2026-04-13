import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { runMessageStoreContract } from "./message-store-contract.js";

runMessageStoreContract("InMemoryMessageStore", () => {
  const store = new InMemoryMessageStore();
  return {
    store,
    readSyncLog: () => store.syncLog,
  };
});
