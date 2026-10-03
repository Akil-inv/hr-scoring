import { Resolver, Query, Args, ObjectType, Field, Int } from '@nestjs/graphql';
import { JudgePortalService } from './judge-portal.service';
import { Roles } from '../auth/roles.decorator';

@ObjectType()
export class JudgeLink {
  @Field() judgeId!: string;
  @Field() name!: string;
  @Field() email!: string;
  @Field() token!: string;
  @Field({ nullable: true }) phone?: string;
  @Field() link!: string;
  /** Zero means this link opens an empty page — worth knowing before sending. */
  @Field(() => Int) sessionCount!: number;
}

@Resolver()
export class JudgePortalResolver {
  constructor(private service: JudgePortalService) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Query(() => [JudgeLink])
  async judgeLinks(@Args('eventId') eventId: string) {
    return this.service.generateAllLinks(eventId);
  }
}
