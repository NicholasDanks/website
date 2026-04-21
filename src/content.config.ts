import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const publications = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/publications' }),
  schema: z.object({
    title: z.string(),
    authors: z.array(z.string()),
    journal: z.string(),
    year: z.number(),
    type: z.enum(['article', 'book', 'chapter', 'conference']),
    doi: z.string().optional(),
    url: z.string().optional(),
    citations: z.number().default(0),
    featured: z.boolean().default(false),
    abstract: z.string().optional(),
  }),
});

const courses = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/courses' }),
  schema: z.object({
    title: z.string(),
    code: z.string(),
    level: z.string(),
    semester: z.string(),
    year: z.string(),
    status: z.enum(['current', 'past']),
    description: z.string(),
    topics: z.array(z.string()),
  }),
});

const software = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/software' }),
  schema: z.object({
    title: z.string(),
    tagline: z.string(),
    role: z.string(),
    cran: z.string().optional(),
    github: z.string().optional(),
    version: z.string().optional(),
    downloads: z.string().optional(),
    featured: z.boolean().default(false),
  }),
});

const tutorials = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/tutorials' }),
  schema: z.object({
    title: z.string(),
    topic: z.string(),
    chapter: z.number(),
    order: z.number(),
    summary: z.string(),
    learningOutcomes: z.array(z.string()),
    videoStatus: z.enum(['planned', 'recorded', 'published']).default('planned'),
    videoUrl: z.string().optional(),
    durationMinutes: z.number().optional(),
    codeFile: z.string().optional(),
    rPractice: z.array(z.string()).default([]),
  }),
});

export const collections = {
  publications,
  courses,
  software,
  tutorials,
};
