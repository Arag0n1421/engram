import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
// Built-in shell/filesystem tools are disabled; this explicit provider avoids a VM requirement.
export const environment = JustBashSandbox.environment({autoInstall: false});
export default defineSandbox(() => environment.open());
