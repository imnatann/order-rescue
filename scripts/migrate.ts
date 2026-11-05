import "./load-env";
import { db, closeDb } from "../src/server/db";
db();
console.log("Database schema is current.");
closeDb();
