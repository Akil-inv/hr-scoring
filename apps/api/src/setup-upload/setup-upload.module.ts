import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { SetupUploadController } from './setup-upload.controller';
import { SetupUploadService } from './setup-upload.service';

@Module({
  imports: [MulterModule.register({ storage: require('multer').memoryStorage() })],
  providers: [SetupUploadService],
  controllers: [SetupUploadController],
})
export class SetupUploadModule {}
