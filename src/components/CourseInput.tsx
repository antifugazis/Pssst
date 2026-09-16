import { useT } from '../i18n';

interface CourseInputProps {
  value: string;
  onChange: (value: string) => void;
  suggestions?: string[];
}

const defaultCourses = ['Architecture des ordinateurs', 'Analyse numérique', 'Systèmes d’exploitation'];

export function CourseInput({ value, onChange, suggestions = [] }: CourseInputProps) {
  const t = useT();
  const courses = Array.from(new Set([...suggestions.filter(Boolean), ...defaultCourses]));
  return (
    <div className="field course-field">
      <div className="field-label-row">
        <label className="field-label" htmlFor="course">{t('field.course')}</label>
        <span className="field-hint">{t('field.course.hint')}</span>
      </div>
      <div className="course-input-wrap">
        <span aria-hidden="true">⌘</span>
        <input
          autoComplete="off"
          id="course"
          list="recent-courses"
          onChange={(event) => onChange(event.target.value)}
          placeholder={t('field.course.ph')}
          value={value}
        />
      </div>
      <datalist id="recent-courses">
        {courses.map((course) => (
          <option key={course} value={course} />
        ))}
      </datalist>
      {!value && (
        <div className="recent-courses">
          <span>{t('field.course.recent')}</span>
          {courses.slice(0, 3).map((course) => (
            <button key={course} onClick={() => onChange(course)} type="button">
              {course}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
