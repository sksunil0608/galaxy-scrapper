export async function healthCheckController() {
  return {
    statusCode: 200,
    body: {
      ok: true,
      service: "scrapper-backend"
    }
  };
}
