import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  getArchiveExtension,
  findProjectRoot,
  extractArchive,
} from '../../src/server/archive-utils.js';
import tar from 'tar';

describe('archive-upload helpers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getArchiveExtension', () => {
    it('recognizes .zip', () => {
      expect(getArchiveExtension('project.zip')).toBe('.zip');
    });

    it('recognizes .tar', () => {
      expect(getArchiveExtension('project.tar')).toBe('.tar');
    });

    it('recognizes .tar.gz', () => {
      expect(getArchiveExtension('project.tar.gz')).toBe('.tar.gz');
    });

    it('recognizes .tgz', () => {
      expect(getArchiveExtension('project.tgz')).toBe('.tgz');
    });

    it('is case-insensitive', () => {
      expect(getArchiveExtension('Project.TAR.GZ')).toBe('.tar.gz');
      expect(getArchiveExtension('Project.TGZ')).toBe('.tgz');
      expect(getArchiveExtension('Project.ZIP')).toBe('.zip');
    });

    it('returns null for unsupported types', () => {
      expect(getArchiveExtension('file.rar')).toBeNull();
      expect(getArchiveExtension('file.7z')).toBeNull();
      expect(getArchiveExtension('file.txt')).toBeNull();
      expect(getArchiveExtension('file.js')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(getArchiveExtension('')).toBeNull();
    });
  });

  describe('findProjectRoot', () => {
    it('unwraps single top-level directory', async () => {
      const innerDir = path.join(tmpDir, 'my-project');
      await fs.mkdir(innerDir, { recursive: true });
      await fs.writeFile(path.join(innerDir, 'index.js'), '// hello');

      const root = await findProjectRoot(tmpDir);
      expect(root).toBe(innerDir);
    });

    it('returns extractDir when multiple top-level entries exist', async () => {
      await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'a');
      await fs.mkdir(path.join(tmpDir, 'src'));

      const root = await findProjectRoot(tmpDir);
      expect(root).toBe(tmpDir);
    });

    it('returns extractDir when only files exist (no dirs)', async () => {
      await fs.writeFile(path.join(tmpDir, 'README.md'), '# hi');
      await fs.writeFile(path.join(tmpDir, 'index.js'), '// code');

      const root = await findProjectRoot(tmpDir);
      expect(root).toBe(tmpDir);
    });

    it('ignores hidden directories', async () => {
      await fs.mkdir(path.join(tmpDir, '.git'));
      await fs.mkdir(path.join(tmpDir, 'project'));
      await fs.writeFile(path.join(tmpDir, 'project', 'main.py'), '# code');

      const root = await findProjectRoot(tmpDir);
      expect(root).toBe(path.join(tmpDir, 'project'));
    });
  });

  describe('extractArchive (tar.gz)', () => {
    it('extracts a tar.gz archive', async () => {
      // Create a source directory with some files
      const srcDir = path.join(tmpDir, 'src-project');
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, 'hello.txt'), 'Hello World');
      await fs.mkdir(path.join(srcDir, 'sub'));
      await fs.writeFile(path.join(srcDir, 'sub', 'nested.txt'), 'Nested');

      // Create a tar.gz from it
      const archivePath = path.join(tmpDir, 'test.tar.gz');
      await tar.create({ gzip: true, file: archivePath, cwd: tmpDir }, ['src-project']);

      // Extract to a new directory
      const destDir = path.join(tmpDir, 'extracted');
      await extractArchive(archivePath, destDir, '.tar.gz');

      // Verify extraction
      const hello = await fs.readFile(path.join(destDir, 'src-project', 'hello.txt'), 'utf-8');
      expect(hello).toBe('Hello World');
      const nested = await fs.readFile(
        path.join(destDir, 'src-project', 'sub', 'nested.txt'),
        'utf-8',
      );
      expect(nested).toBe('Nested');
    });
  });
});
