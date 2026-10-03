import { Query, Resolver } from '@nestjs/graphql';
import { Public } from './auth/public.decorator';

@Resolver()
export class HealthResolver {
  @Public()
  @Query(() => String)
  health(): string {
    return 'ok';
  }
}
