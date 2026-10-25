import { migrateDb } from "./migrate.js";
import { migratePlaintextServiceEnv } from "../services/secrets.js";

migrateDb();
const result = await migratePlaintextServiceEnv();
console.log(
  `service env encryption: servicesChecked=${result.servicesChecked} servicesUpdated=${result.servicesUpdated} envValuesEncrypted=${result.envValuesEncrypted} failed=${result.failed}`,
);
if (result.failed > 0) {
  process.exitCode = 1;
}
