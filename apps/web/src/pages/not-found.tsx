import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="py-24 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="mt-2 text-xl font-semibold">Page not found</h1>
      <Link to="/channels" className="mt-4 inline-block text-sm underline">
        Go to channels
      </Link>
    </div>
  );
}
