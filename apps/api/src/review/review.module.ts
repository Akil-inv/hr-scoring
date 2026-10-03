import { Module } from '@nestjs/common';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

@Module({
  providers: [ReviewService],
  controllers: [ReviewController],
})
export class ReviewModule {}
