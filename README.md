# kb-thumb

Kpop Baby 큐텐 대표이미지(800x800)를 자동으로 만드는 저장소입니다.

- 매시 17분에 리스팅관리 시트의 `대표이미지_작업` 탭을 읽어, 대표이미지 주소가 비어 있는 줄만 이미지를 만듭니다.
- 만든 이미지는 `img/<코드>.jpg`로 저장되고 `https://loveisallinc-lang.github.io/kb-thumb/img/<코드>.jpg` 주소로 열립니다.
- 다시 만들고 싶으면 시트에서 그 줄의 대표이미지 주소 칸을 비우면 됩니다.
- 디자인은 사장님 샘플 3장 기준입니다. 로고 띠는 `assets/header.png`, 특전 배지는 `assets/badge.png`, 위치·색은 `make_thumbs.py` 위쪽 "디자인 틀"에서 바꿉니다.

필요한 비밀값: `GOOGLE_SA_JSON` (구글 서비스 계정 키 JSON). 서비스 계정 이메일을 리스팅관리 시트에 편집자로 공유해야 합니다.
