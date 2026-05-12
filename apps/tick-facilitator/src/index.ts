// Thin Worker that fronts the Faremeter container.
//
// Cloudflare Containers binding: getContainer(env.FACILITATOR).fetch(req)
// forwards to the container's exposed port (3000), where Faremeter's Hono app
// handles /verify, /settle, /v2/*, /mpp/* etc.

import { Container, getContainer } from "@cloudflare/containers";

export class FaremeterFacilitator extends Container {
  override defaultPort = 3000;
  override sleepAfter = "10m"; // hibernate when idle to save active CPU
}

type Env = {
  FACILITATOR: DurableObjectNamespace<FaremeterFacilitator>;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return getContainer(env.FACILITATOR).fetch(req);
  },
};
