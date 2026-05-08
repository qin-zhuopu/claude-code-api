import { IsOptional, IsString, IsNotEmpty } from 'class-validator';

export class QueryOptionsDto {
  @IsOptional()
  @IsString()
  cwd?: string;

  @IsOptional()
  @IsString()
  model?: string;
}

export class QueryRequestDto {
  @IsString()
  @IsNotEmpty()
  prompt: string;

  @IsOptional()
  options?: QueryOptionsDto;
}
