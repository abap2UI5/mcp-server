CLASS zcl_bench_11 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_todo,
        id   TYPE i,
        text TYPE string,
        done TYPE abap_bool,
      END OF ty_s_todo.
    TYPES ty_t_todo TYPE STANDARD TABLE OF ty_s_todo WITH EMPTY KEY.
    DATA new_text TYPE string.
    DATA filter   TYPE string.
    DATA visible  TYPE ty_t_todo.

  PROTECTED SECTION.
    DATA todos   TYPE ty_t_todo.
    DATA last_id TYPE i.
    DATA client  TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS sync_done.
    METHODS apply_filter.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_11 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`        v = `sap.m`
            )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(page) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `To-do` ).

    page->ele( `HBox`
        )->a( n = `class` v = `sapUiSmallMargin`

        )->tag( `Input`
            )->a( n = `value`       v = client->_bind( new_text )
            )->a( n = `placeholder` v = `What needs to be done?`
            )->a( n = `width`       v = `20rem`
        )->tag( `Button`
            )->a( n = `text`  v = `Add`
            )->a( n = `type`  v = `Emphasized`
            )->a( n = `press` v = client->_event( `ADD` ) ).

    DATA(list) = page->ele( `List`
        )->a( n = `items` v = client->_bind( visible ) ).

    list->ele( `headerToolbar`
        )->ele( `OverflowToolbar`
            )->ele( `SegmentedButton`
                )->a( n = `selectedKey`      v = client->_bind( filter )
                )->a( n = `selectionChange` v = client->_event( `FILTER` )
                )->ele( `items`

                    )->tag( `SegmentedButtonItem`
                        )->a( n = `key`  v = `ALL`
                        )->a( n = `text` v = `All`
                    )->tag( `SegmentedButtonItem`
                        )->a( n = `key`  v = `OPEN`
                        )->a( n = `text` v = `Open`
                    )->tag( `SegmentedButtonItem`
                        )->a( n = `key`  v = `DONE`
                        )->a( n = `text` v = `Done`

                )->end(
            )->end(
            )->tag( `ToolbarSpacer`
            )->tag( `Button`
                )->a( n = `text`  v = `Remove done`
                )->a( n = `press` v = client->_event( `REMOVE_DONE` ) ).

    list->ele( `items`
        )->ele( `CustomListItem`
            )->tag( `CheckBox`
                )->a( n = `text`     v = `{TEXT}`
                )->a( n = `selected` v = `{DONE}`
                )->a( n = `select`   v = client->_event( `TOGGLE` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    sync_done( ).
    CASE client->get_event( ).
      WHEN `ADD`.
        IF condense( new_text ) IS INITIAL.
          client->message_toast_display( `Enter a text first` ).
        ELSE.
          last_id = last_id + 1.
          APPEND VALUE #( id = last_id text = new_text ) TO todos.
          new_text = ``.
        ENDIF.
        apply_filter( ).
      WHEN `REMOVE_DONE`.
        DELETE todos WHERE done = abap_true.
        apply_filter( ).
      WHEN `FILTER` OR `TOGGLE`.
        " a tick or a filter change: the rows shown follow both
        apply_filter( ).
    ENDCASE.

  ENDMETHOD.

  METHOD sync_done.

    " the ticks arrive in the visible rows; carry them into the full list
    LOOP AT visible INTO DATA(row).
      READ TABLE todos ASSIGNING FIELD-SYMBOL(<todo>) WITH KEY id = row-id.
      IF sy-subrc = 0.
        <todo>-done = row-done.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

  METHOD apply_filter.

    CLEAR visible.
    LOOP AT todos INTO DATA(todo).
      IF filter = `ALL`
          OR ( filter = `OPEN` AND todo-done = abap_false )
          OR ( filter = `DONE` AND todo-done = abap_true ).
        APPEND todo TO visible.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

  METHOD model_init.

    todos   = VALUE #( ( id = 1 text = `Book the meeting room` done = abap_true )
                       ( id = 2 text = `Send the agenda`       done = abap_false )
                       ( id = 3 text = `Order lunch`           done = abap_false ) ).
    last_id = 3.
    filter  = `ALL`.
    apply_filter( ).

  ENDMETHOD.

ENDCLASS.
