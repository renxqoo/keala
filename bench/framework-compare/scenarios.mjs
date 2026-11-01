// Independent expected responses, also checked on every request under load.
export const HELLO = [{ method: "GET", route: "/", path: "/", body: "Hello World" }];

export const ROUTES = [
  { method: "GET", route: "/user", path: "/user", body: "user" },
  { method: "GET", route: "/user/comments", path: "/user/comments", body: "user/comments" },
  { method: "GET", route: "/user/avatar", path: "/user/avatar", body: "user/avatar" },
  {
    method: "GET",
    route: "/user/lookup/username/:username",
    path: "/user/lookup/username/hey",
    body: "hey",
  },
  {
    method: "GET",
    route: "/user/lookup/email/:address",
    path: "/user/lookup/email/hello@example.com",
    body: "hello@example.com",
  },
  { method: "GET", route: "/event/:id", path: "/event/abcd1234", body: "abcd1234" },
  {
    method: "GET",
    route: "/event/:id/comments",
    path: "/event/abcd1234/comments",
    body: "abcd1234",
  },
  {
    method: "POST",
    route: "/event/:id/comment",
    path: "/event/abcd1234/comment",
    body: "abcd1234 comment",
  },
  {
    method: "GET",
    route: "/map/:location/events",
    path: "/map/singapore/events",
    body: "singapore",
  },
  { method: "GET", route: "/status", path: "/status", body: "status" },
  {
    method: "GET",
    route: "/very/deeply/nested/route/hello/there",
    path: "/very/deeply/nested/route/hello/there",
    body: "hello there",
  },
  { method: "GET", route: "/static/*", path: "/static/index.html", body: "index.html" },
];

export const EXTRA_CHECKS = [
  { method: "GET", path: "/user/lookup/username/another-user", body: "another-user" },
  { method: "GET", path: "/user/lookup/email/a+b@example.org", body: "a+b@example.org" },
  { method: "GET", path: "/event/second/comments", body: "second" },
  { method: "POST", path: "/event/second/comment", body: "second comment" },
  { method: "GET", path: "/map/tokyo/events", body: "tokyo" },
  { method: "GET", path: "/static/css/app.css", body: "css/app.css" },
];
