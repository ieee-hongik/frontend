# 홍익대학교 IEEE 웹사이트 — Frontend

홍익대학교 IEEE 웹사이트의 프론트엔드 저장소입니다.

## 관련 저장소

- Frontend: https://github.com/ieee-hongik/frontend
- Backend: https://github.com/ieee-hongik/backend

## 기술 방향

- React · TypeScript
- Tailwind CSS
- Zustand
- TanStack Query

## 개발 환경

- Node.js: 24.21.0
- npm: 11.19.0
- 빌드 도구: Vite
- 린터: ESLint
- 패키지 매니저: npm

의존성 버전 범위는 package.json에서, 정확한 설치 버전은
package-lock.json에서 관리합니다.

## 공통 라이브러리

- Tailwind CSS: Vite 플러그인 및 공통 CSS 연결
- Zustand: 설치 완료, 기능별 store는 추후 작성
- TanStack Query: QueryClientProvider 연결
- TanStack Query Devtools: 개발 환경에서 사용
- React Router: BrowserRouter 연결, 페이지별 라우트는 추후 작성
- Prettier: 공통 코드 포맷 적용
- ESLint: 코드 검사 및 Prettier 충돌 방지 설정 적용

코드 포맷 적용: npm run format
코드 포맷 검사: npm run format:check

## 설치 및 실행

저장소 루트에서 실행합니다.

```sh
npm ci
npm run dev
```

개발 서버 주소는 터미널의 Local 항목을 확인합니다.

## 코드 검사 및 빌드

```sh
npm run lint
npm run build
```

빌드 결과는 dist 폴더에 생성됩니다.

## 브랜치 규칙

| 브랜치         | 용도                     |
| -------------- | ------------------------ |
| main           | 배포 브랜치              |
| dev            | 개발 통합 브랜치         |
| 타입/#이슈번호 | 작업 브랜치. 예: feat/#1 |

- 작업 브랜치는 최신 dev에서 생성합니다.
- 작업 브랜치에서 dev로 PR을 생성합니다.
- PR 작성자를 제외한 다른 개발자 최소 1명의 승인을 받습니다.
- 작업 브랜치 → dev: Squash and merge
- dev → main: Create a merge commit
- main·dev에 직접 푸시하지 않고 PR로 변경합니다.
- main 관리 및 머지 담당자는 추후 확정합니다.

저장소 초기 파일과 main·dev 생성은 보호 설정 적용 전에 진행합니다.

## 커밋 규칙

- 형식: 타입: 변경 내용
- 타입은 영문 소문자, 설명은 한글로 작성합니다.
- 제목 끝에 마침표를 붙이지 않습니다.
- 커밋에 이슈 번호를 넣지 않습니다.
- 본문은 변경 내용과 이유를 추가로 설명해야 할 때만 작성합니다.
- 관련 이슈는 작업 브랜치 이름과 PR에 표시합니다.

| 타입     | 용도                            |
| -------- | ------------------------------- |
| feat     | 새로운 기능 추가                |
| fix      | 버그 수정                       |
| refactor | 기능 변경 없는 코드 구조 개선   |
| docs     | 문서 작성 및 수정               |
| chore    | 기타 유지보수 작업              |
| build    | 빌드 설정 및 의존성 변경        |
| test     | 테스트 추가 및 수정             |
| style    | 들여쓰기·공백 등 코드 형식 변경 |
| design   | UI·CSS 변경                     |

예: feat: 공지사항 목록 조회 구현
예: chore: 저장소 협업 기반 초기 설정

## 환경 설정

실제 비밀값을 포함한 환경 파일은 커밋하지 않습니다.
필요한 환경변수가 정해지면 비밀값 없이 .env.example에 작성합니다.
