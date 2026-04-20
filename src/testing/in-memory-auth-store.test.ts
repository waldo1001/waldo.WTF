import { runAuthStoreContract } from "../auth/oauth/auth-store-contract.js";
import { InMemoryAuthStore } from "./in-memory-auth-store.js";

runAuthStoreContract("InMemoryAuthStore", () => new InMemoryAuthStore());
