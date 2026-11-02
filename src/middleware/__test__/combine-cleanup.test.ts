import { expect, it, vi } from "vitest";
import { Keala } from "../../index.ts";
import { all, some } from "../index.ts";
import type { RouteHandler } from "../../index.ts";

function streamingResponse(status = 401) {
  const cancelled = vi.fn();
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        producer = controller;
        controller.enqueue(new TextEncoder().encode("stream"));
      },
      cancel: cancelled,
    }),
    { status },
  );
  return { response, cancelled, finish: () => producer.close() };
}

it("short-circuits some() after an all() group answers successfully", async () => {
  const denied = vi.fn(() => new Response("denied", { status: 403 }));
  const app = new Keala({ env: "test" });
  app.use(
    some(
      all((c) => c.text("success")),
      denied,
    ),
  );

  const response = await app.handle(new Request("http://localhost/"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("success");
  expect(denied).not.toHaveBeenCalled();
});

it("discards an all() refusal when a later some() candidate reaches a route with no answer", async () => {
  const discarded = streamingResponse();
  const app = new Keala({ env: "test" });
  app.use(
    some(
      all(() => discarded.response),
      (_c, next) => next(),
    ),
  );
  app.get("/", () => undefined);

  const response = await app.handle(new Request("http://localhost/"));
  expect(response.status).toBe(404);
  await response.text();
  expect(discarded.cancelled).toHaveBeenCalledTimes(1);
});

it("keeps the prior committed stream when an all() refusal loses inside some()", async () => {
  const retained = streamingResponse(200);
  const discarded = streamingResponse();
  const guard = some(
    all(() => discarded.response),
    (_c, next) => next(),
  );
  const app = new Keala({ env: "test" });
  app.use(async (c, next) => {
    await next();
    return guard(c, async () => {});
  });
  app.get("/", () => retained.response);

  const response = await app.handle(new Request("http://localhost/"));
  expect(response.status).toBe(200);
  expect(retained.cancelled).not.toHaveBeenCalled();
  expect(discarded.cancelled).toHaveBeenCalledTimes(1);
  retained.finish();
  expect(await response.text()).toBe("stream");
});

it("cancels a late all() answer and keeps its pending branch out of the context pool", async () => {
  const discarded = streamingResponse(200);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let owner: unknown;
  const app = new Keala({ env: "test", pooling: true });
  app.get(
    "/first",
    all(
      (c, next) => {
        c.state["owner"] = "first";
        void next().then(finish, finish);
        return c.text("outer");
      },
      async (c) => {
        await gate;
        owner = c.state["owner"];
        return discarded.response;
      },
    ),
  );
  app.get("/second", (c) => {
    c.state["owner"] = "second";
    return c.text("second");
  });

  expect(await (await app.handle(new Request("http://localhost/first"))).text()).toBe("outer");
  expect(await (await app.handle(new Request("http://localhost/second"))).text()).toBe("second");
  release();
  await finished;
  expect(owner).toBe("first");
  expect(discarded.cancelled).toHaveBeenCalledTimes(1);
});

it("keeps nested late all() branches out of the pool after an earlier branch settles", async () => {
  const discarded = streamingResponse(200);
  let releaseMiddle!: () => void;
  const middleGate = new Promise<void>((resolve) => {
    releaseMiddle = resolve;
  });
  let releaseInner!: () => void;
  const innerGate = new Promise<void>((resolve) => {
    releaseInner = resolve;
  });
  let finishMiddle!: () => void;
  const middleFinished = new Promise<void>((resolve) => {
    finishMiddle = resolve;
  });
  let finishInner!: () => void;
  const innerFinished = new Promise<void>((resolve) => {
    finishInner = resolve;
  });
  let owner: unknown;
  const app = new Keala({ env: "test", pooling: true });
  app.get(
    "/first",
    all(
      (c, next) => {
        c.state["owner"] = "first";
        void next().then(finishMiddle, finishMiddle);
        return c.text("outer");
      },
      async (c, next) => {
        await middleGate;
        void next().then(finishInner, finishInner);
        return c.text("middle");
      },
      async (c) => {
        await innerGate;
        owner = c.state["owner"];
        return discarded.response;
      },
    ),
  );
  app.get("/second", (c) => {
    c.state["owner"] = "second";
    return c.text("second");
  });

  expect(await (await app.handle(new Request("http://localhost/first"))).text()).toBe("outer");
  releaseMiddle();
  await middleFinished;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await (await app.handle(new Request("http://localhost/second"))).text()).toBe("second");
  releaseInner();
  await innerFinished;
  expect(owner).toBe("first");
  expect(discarded.cancelled).toHaveBeenCalledTimes(1);
});

it.each(["success", "next", "refusal", "throw", "throw after next"])(
  "cancels a discarded refusal when some() finishes with %s",
  async (outcome) => {
    const discarded = streamingResponse();
    const candidate: RouteHandler = async (_c, next) => {
      if (outcome.includes("next")) await next();
      if (outcome.startsWith("throw")) throw new Error("candidate failed");
      if (outcome === "success") return new Response("success");
      if (outcome === "refusal") return new Response("refusal", { status: 403 });
    };
    const app = new Keala({ env: "test" });
    app.onError(() => new Response("mapped", { status: 500 }));
    app.use(some(() => discarded.response, candidate));
    app.get("/", (c) => c.text("downstream"));

    const response = await app.handle(new Request("http://localhost/"));
    expect(await response.text()).toBe(
      outcome.startsWith("throw") ? "mapped" : outcome === "next" ? "downstream" : outcome,
    );
    expect(discarded.cancelled).toHaveBeenCalledTimes(1);
  },
);

it("keeps the final some() refusal consumable while cancelling earlier refusals", async () => {
  const discarded = streamingResponse();
  const retained = streamingResponse(403);
  const app = new Keala({ env: "test" });
  app.use(
    some(
      () => discarded.response,
      () => retained.response,
    ),
  );

  const response = await app.handle(new Request("http://localhost/"));
  expect(discarded.cancelled).toHaveBeenCalledTimes(1);
  expect(retained.cancelled).not.toHaveBeenCalled();
  retained.finish();
  expect(response.status).toBe(403);
  expect(await response.text()).toBe("stream");
});

it.each(["same response", "same body", "downstream body"])(
  "keeps a some() winner's stream when it retains the %s",
  async (mode) => {
    const retained = streamingResponse();
    const app = new Keala({ env: "test" });
    app.use(
      some(
        () => retained.response,
        (_c, next) => {
          if (mode === "downstream body") return next();
          return mode === "same response"
            ? retained.response
            : new Response(retained.response.body);
        },
      ),
    );
    app.get("/", () => new Response(retained.response.body));

    const response = await app.handle(new Request("http://localhost/"));
    expect(retained.cancelled).not.toHaveBeenCalled();
    retained.finish();
    expect(await response.text()).toBe("stream");
  },
);

it.each(["replacement", "throw"])(
  "cancels a discarded all() answer after an outer %s",
  async (outcome) => {
    const discarded = streamingResponse(200);
    const app = new Keala({ env: "test" });
    app.onError(() => new Response("mapped", { status: 500 }));
    app.use(
      all(
        async (_c, next) => {
          await next();
          if (outcome === "throw") throw new Error("outer failed");
          return new Response("replacement");
        },
        () => discarded.response,
      ),
    );

    const response = await app.handle(new Request("http://localhost/"));
    expect(await response.text()).toBe(outcome === "throw" ? "mapped" : "replacement");
    expect(discarded.cancelled).toHaveBeenCalledTimes(1);
  },
);

it.each(["same response", "same body"])(
  "keeps an all() answer's stream when an outer candidate retains the %s",
  async (mode) => {
    const retained = streamingResponse(200);
    const app = new Keala({ env: "test" });
    app.use(
      all(
        async (_c, next) => {
          await next();
          return mode === "same response"
            ? retained.response
            : new Response(retained.response.body);
        },
        () => retained.response,
      ),
    );

    const response = await app.handle(new Request("http://localhost/"));
    expect(retained.cancelled).not.toHaveBeenCalled();
    retained.finish();
    expect(await response.text()).toBe("stream");
  },
);
