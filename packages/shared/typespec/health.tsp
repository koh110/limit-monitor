import "@typespec/http";

using Http;

namespace LimitMonitor;

model HealthOk {
  status: "ok";

  /** Hub の実装バージョン(`packages/hub/src/config.ts` の APP_VERSION) */
  version: string;

  schemaVersion: SchemaVersion;
}

model HealthOkResponse {
  @statusCode statusCode: 200;
  @body body: HealthOk;
}

@route("/healthz")
interface HealthzApi {
  /** process health。DB へは触らない */
  @tag("Health")
  @summary("healthz")
  @get
  healthz(): HealthOkResponse;
}

@route("/readyz")
interface ReadyzApi {
  /** DB 到達性を含む readiness */
  @tag("Health")
  @summary("readyz")
  @get
  readyz():
    | HealthOkResponse
    | {
        @statusCode statusCode: 503;
        @body body: {
          status: "unavailable";
        };
      };
}
