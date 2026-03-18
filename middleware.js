// EdgeOne Pages Middleware - 请求直接放行
export function middleware(context) {
  return context.next();
}
