import { getCurrentUser } from "@/lib/auth";
import { Nav } from "@/components/nav";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-xl font-semibold">Not authorised</h1>
        <p className="text-sm text-slate-600">
          Your account is not permitted to access this application. Contact an
          administrator to be added.
        </p>
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="text-sm font-bold tracking-tight text-slate-900">
              Excel Capital
            </span>
            <Nav role={user.role} />
          </div>
          <div className="text-right text-xs text-slate-500">
            <div className="font-medium text-slate-700">{user.email}</div>
            <div className="capitalize">{user.role}</div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
