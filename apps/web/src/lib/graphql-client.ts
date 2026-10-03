import { Client, cacheExchange, fetchExchange } from 'urql';

export function createClient(token: string | null) {
  return new Client({
    url: process.env.NEXT_PUBLIC_API_URL || '/graphql',
    exchanges: [cacheExchange, fetchExchange],
    fetchOptions: () => ({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  });
}
