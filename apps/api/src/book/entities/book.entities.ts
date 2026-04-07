import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'book' })
export class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'book_name', type: 'varchar', length: 255 })
  bookName!: string;

  @Column({ name: 'book_name_pinyin', type: 'varchar', length: 255, unique: true })
  bookNamePinyin!: string;

  @Column({ name: 'milvus_collection', type: 'varchar', length: 255, unique: true })
  milvusCollection!: string;

  @Column({ name: 'file_path', type: 'varchar', length: 1024 })
  filePath!: string;

  @Column({ name: 'original_file_name', type: 'varchar', length: 255 })
  originalFileName!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
