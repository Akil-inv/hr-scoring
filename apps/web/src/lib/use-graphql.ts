'use client';

import { useEffect, useState } from 'react';
import { useAuthStore } from './auth-store';
import { createClient } from './graphql-client';

export function useQuery<T>(query: string, variables?: Record<string, any>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    const client = createClient(token);
    client.query(query, variables || {}).toPromise().then((result) => {
      if (result.error) setError(result.error.message);
      else setData(result.data);
      setLoading(false);
    });
  }, [query, token, JSON.stringify(variables)]);

  return { data, loading, error };
}
