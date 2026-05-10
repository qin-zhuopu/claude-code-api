import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 启用 CORS
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // 全局验证管道
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
  }));

  const port = process.env.PORT || 3000;
  await app.listen(port);

  // 获取实际监听的端口（当 port=0 时，系统会分配随机端口）
  const server = app.getHttpServer();
  const address = server.address();
  const actualPort = typeof address === 'string' ? address : address?.port;
  console.log(`Application is running on http://localhost:${actualPort}`);
}
bootstrap();
