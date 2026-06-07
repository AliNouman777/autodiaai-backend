//src/utils/http.ts
export function ok<T>(data: T) {
  return { success: true, data };
}

export function fail(message: string, code = "BAD_REQUEST") {
  return { success: false, message, code };
}
