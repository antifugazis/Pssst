interface CourseInputProps {
  value: string;
  onChange: (value: string) => void;
  suggestions?: string[];
}

const defaultCourses = ['Architecture des ordinateurs', 'Analyse numérique', 'Systèmes d’exploitation'];

export function CourseInput({ value, onChange, suggestions = [] }: CourseInputProps) {
  const courses = Array.from(new Set([...suggestions.filter(Boolean), ...defaultCourses]));
  return (
    <div className="field course-field">
      <div className="field-label-row">
        <label className="field-label" htmlFor="course">Cours</label>
        <span className="field-hint">Pour retrouver et continuer l’enregistrement</span>
      </div>
      <div className="course-input-wrap">
        <span aria-hidden="true">⌘</span>
        <input
          autoComplete="off"
          id="course"
          list="recent-courses"
          onChange={(event) => onChange(event.target.value)}
          placeholder="Ex. Architecture des ordinateurs"
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
          <span>Récents</span>
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
